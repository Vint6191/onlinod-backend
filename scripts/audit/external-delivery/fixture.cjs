'use strict';
process.env.TZ='UTC';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
if(!process.env.ONLINOD_SQL_PROOF_RUNTIME)throw Error('ONLINOD_SQL_PROOF_RUNTIME must point to a local PGlite installation');
const runtime=path.resolve(process.env.ONLINOD_SQL_PROOF_RUNTIME);
const {PGlite}=require(path.join(runtime,'node_modules/@electric-sql/pglite'));
const {PGLiteSocketServer}=require(path.join(runtime,'node_modules/@electric-sql/pglite-socket'));
const {PrismaClient}=require(process.env.ONLINOD_PROOF_PRISMA_CLIENT || '@prisma/client');
const root=path.resolve(__dirname,'../../..');
const MIGRATION='20261005000000_external_delivery_authority_v2';
const MIGRATIONS=[MIGRATION,'20261005001000_external_delivery_maintenance_v5'];
async function fixture(){
  const pg=await PGlite.create();await pg.exec("SET TIME ZONE 'UTC'");
  const history=JSON.parse(fs.readFileSync(path.join(root,'scripts/database/phase7-applied-history.json'))).migrations;
  const skipped=['20260930190000_phase7_legacy_storage_contract_v1',...MIGRATIONS];
  const names=fs.readdirSync(path.join(root,'prisma/migrations')).filter(n=>!skipped.includes(n)&&fs.existsSync(path.join(root,'prisma/migrations',n,'migration.sql'))).sort();
  for(const name of names){
    const h=history.find(x=>x.migration===name),file=h?path.join(root,'scripts/database/phase7-applied-history',name,h.storedChecksum+'.sql'):path.join(root,'prisma/migrations',name,'migration.sql');
    try{await pg.exec(fs.readFileSync(file,'utf8'));}catch(e){e.message=name+': '+e.message;throw e;}
  }
  if(process.env.ONLINOD_PROOF_OUTPUT)fs.writeFileSync(path.join(process.env.ONLINOD_PROOF_OUTPUT,'external-delivery-schema.json'),JSON.stringify({installed:names,skipped,runtime:'PGlite 0.5.8 / PostgreSQL 18.3; single connection; not native concurrency'},null,2)+'\n');
  let server=new PGLiteSocketServer({db:pg,host:'127.0.0.1',port:0});await server.start();
  const url=`postgresql://postgres:postgres@${server.getServerConn()}/postgres?connection_limit=1&sslmode=disable`;
  const queries=[];
  const db=new PrismaClient({datasources:{db:{url}},log:[{emit:'event',level:'query'}]});
  db.$on('query',q=>queries.push({query:q.query,params:q.params,duration:q.duration}));
  require.cache[path.join(root,'src/prisma.js')]={exports:db};

  return {db,pg,root,url,queries,async migrate(){
      const port=Number(new URL(url).port);await db.$disconnect();await server.stop();await new Promise(resolve=>setImmediate(resolve));
      await pg.exec('DISCARD ALL');for(const name of MIGRATIONS)await pg.exec(fs.readFileSync(path.join(root,'prisma/migrations',name,'migration.sql'),'utf8'));
      server=new PGLiteSocketServer({db:pg,host:'127.0.0.1',port});await server.start();await db.$connect();
    },
    async close(){await db.$disconnect();await server.stop();await pg.close();}};
}
const source=fs.readFileSync(path.join(root,'scripts/audit/analytics-traffic/fixture.cjs'),'utf8');
const context={module:{exports:{}}};vm.runInNewContext(source.slice(source.indexOf('async function scope('),source.indexOf('module.exports='))+'\nmodule.exports=scope;',context);
module.exports={fixture,scope:context.module.exports,MIGRATION};

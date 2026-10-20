"use strict";
const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto");
const {execFileSync}=require("node:child_process"),{PrismaClient}=require("@prisma/client");
async function createScaleSqlRuntime({ beforeMigration = null } = {}) {
 const migrations=require("./proof-migration-chain.cjs").selectProofMigrations(beforeMigration);
 const explicit=process.env.ONLINOD_NATIVE_TEST_DATABASE_URL;
 if(!explicit) return {...await require("./admin-sql-runtime.cjs").createAdminSqlRuntime({runtimePath:process.env.ONLINOD_SQL_PROOF_RUNTIME,beforeMigration}),native:false};
 const url=new URL(explicit),name=decodeURIComponent(url.pathname.slice(1));
 // This helper installs a schema. It deliberately cannot target an application's
 // DATABASE_URL, an arbitrary remote host, or an existing populated database.
 if(!["127.0.0.1","localhost","[::1]"].includes(url.hostname)||!/^onlinod_test_[a-z0-9_]+$/.test(name))throw Error("ISOLATED_LOCAL_POSTGRES_TEST_DATABASE_REQUIRED");
 const db=new PrismaClient({datasources:{db:{url:explicit+(url.search?"&":"?")+"connection_limit=8"}},log:[{emit:"event",level:"query"}]});
 const queries=[];db.$on("query",e=>queries.push({query:e.query,duration:e.duration}));
 const existing=await db.$queryRawUnsafe("SELECT tablename FROM pg_tables WHERE schemaname='public' LIMIT 1");
 if(existing.length){await db.$disconnect();throw Error("POSTGRES_TEST_DATABASE_MUST_BE_EMPTY");}
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"onlinod-scale-schema-")),root=path.resolve(__dirname,"../..");
 const env={...process.env,PGHOST:url.hostname,PGPORT:url.port||"5432",PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),PGDATABASE:name,PGSSLMODE:"disable"};
 const run=file=>execFileSync("psql",["--no-psqlrc","--set","ON_ERROR_STOP=1","--file",file],{env,stdio:["ignore","pipe","pipe"]});
 try {
  for(const item of migrations) {
   const file=path.join(root,"prisma/migrations",item.migration,"migration.sql");
   if(crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")!==item.checksum)throw Error("BASELINE_SOURCE_CHECKSUM_MISMATCH");
   run(file);
  }
  const file=path.join(dir,"ledger.sql");
  fs.writeFileSync(file,`CREATE TABLE "_prisma_migrations" (id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL,
   finished_at timestamptz,migration_name varchar(255) NOT NULL,logs text,rolled_back_at timestamptz,
   started_at timestamptz NOT NULL DEFAULT now(),applied_steps_count integer NOT NULL DEFAULT 0);`);
  run(file);
  for(const item of migrations)await db.$executeRawUnsafe('INSERT INTO "_prisma_migrations"(id,checksum,migration_name,finished_at,applied_steps_count) VALUES($1,$2,$3,now(),1)',crypto.randomUUID(),item.checksum,item.migration);
  return {db,url:explicit,queries,native:true,migrations:migrations.map(item=>item.migration),close:()=>db.$disconnect()};
 }catch(error){await db.$disconnect();throw error;}finally{fs.rmSync(dir,{recursive:true,force:true});}
}
module.exports={createScaleSqlRuntime};
